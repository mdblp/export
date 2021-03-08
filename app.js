/* eslint no-restricted-syntax: [0, "ForInStatement"] */

import _ from 'lodash';
import fs from 'fs';
import http from 'http';
import https from 'https';
import axios from 'axios';
import express from 'express';
import bodyParser from 'body-parser';
import queryString from 'query-string';
import dataTools from '@tidepool/data-tools';
import * as CSV from 'csv-string';
import es from 'event-stream';
import { Registry, Counter, collectDefaultMetrics } from 'prom-client';
import { createTerminus } from '@godaddy/terminus';
import logMaker from './log';

const log = logMaker('app.js', { level: process.env.DEBUG_LEVEL || 'debug' });

const register = new Registry();

collectDefaultMetrics({ register });

const createCounter = (name, help, labelNames) => new Counter({
  name, help, labelNames, registers: [register],
});

const statusCount = createCounter('tidepool_export_status_count', 'The number of errors for each status code.', ['status_code', 'export_format']);

function maybeReplaceWithContentsOfFile(obj, field) {
  const potentialFile = obj[field];
  if (potentialFile != null && fs.existsSync(potentialFile)) {
    // eslint-disable-next-line no-param-reassign
    obj[field] = fs.readFileSync(potentialFile).toString();
  }
}

const config = {};
config.httpPort = process.env.EXPORT_HTTP_PORT || '9300';
config.httpsPort = process.env.EXPORT_HTTPS_PORT;
if (process.env.EXPORT_HTTPS_CONFIG) {
  config.httpsConfig = JSON.parse(process.env.EXPORT_HTTPS_CONFIG);
  maybeReplaceWithContentsOfFile(config.httpsConfig, 'key');
  maybeReplaceWithContentsOfFile(config.httpsConfig, 'cert');
} else {
  config.httpsConfig = {};
}
if (!config.httpPort) {
  config.httpPort = 9300;
}

config.exportTimeout = _.defaultTo(parseInt(process.env.EXPORT_TIMEOUT, 10), 120000);
log.info(`Export download timeout set to ${config.exportTimeout} ms`);
config.tideWhispererService = process.env.TIDE_WHISPERER_SERVICE;
if (_.isEmpty(config.tideWhispererService)) {
  log.error('TIDE_WHISPERER_SERVICE config value is required.');
  process.exit(1);
}
config.sessionSecret = process.env.SESSION_SECRET;
if (_.isEmpty(config.sessionSecret)) {
  log.error('SESSION_SECRET config value required.');
  process.exit(1);
}

const app = express();

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(register.metrics());
});

function buildHeaders(request) {
  if (request.headers['x-tidepool-session-token']) {
    return {
      headers: {
        'x-tidepool-session-token': request.headers['x-tidepool-session-token'],
      },
    };
  }
  return {};
}

log.info('set engine');

app.use(bodyParser.urlencoded({
  extended: false,
}));

log.info('config');

// The Health Check
app.use('/export/status', require('express-healthcheck')());

let nExportInProgress = 0;
app.get('/export/:userid', async (req, res) => {
  nExportInProgress += 1;
  // Set the timeout for the request. Make it 10 seconds longer than
  // our configured timeout to give the service time to cancel the API data
  // request, and close the outgoing data stream cleanly.
  req.setTimeout(config.exportTimeout + 10000);

  const queryData = [];

  let logString = `Requesting download for User ${req.params.userid}`;
  if (req.query.bgUnits) {
    logString += ` in ${req.query.bgUnits}`;
  }
  if (req.query.startDate) {
    queryData.startDate = req.query.startDate;
    logString += ` from ${req.query.startDate}`;
  }
  if (req.query.endDate) {
    queryData.endDate = req.query.endDate;
    logString += ` until ${req.query.endDate}`;
  }
  if (req.query.restricted_token) {
    queryData.restricted_token = req.query.restricted_token;
    logString += ' with restricted_token';
  }
  log.info(logString);

  const exportFormat = req.query.format;

  try {
    const cancelRequest = axios.CancelToken.source();

    const requestConfig = buildHeaders(req);
    requestConfig.responseType = 'stream';
    requestConfig.cancelToken = cancelRequest.token;
    const dataResponse = await axios.get(`${config.tideWhispererService}/${req.params.userid}?${queryString.stringify(queryData)}`, requestConfig);
    log.debug(`Downloading data for User ${req.params.userid}...`);

    const processorConfig = { bgUnits: req.query.bgUnits || 'mmol/L' };

    let writeStream = null;

    if (exportFormat === 'json') {
      res.attachment('TidepoolExport.json');
      writeStream = dataTools.jsonStreamWriter();

      dataResponse.data
        .pipe(dataTools.jsonParser())
        .pipe(dataTools.splitPumpSettingsData())
        .pipe(dataTools.tidepoolProcessor(processorConfig))
        .pipe(writeStream)
        .pipe(res);
    } else if (req.query.format === 'xlsx') {
      res.attachment('TidepoolExport.xlsx');
      writeStream = dataTools.xlsxStreamWriter(res, processorConfig);

      dataResponse.data
        .pipe(dataTools.jsonParser())
        .pipe(dataTools.splitPumpSettingsData())
        .pipe(dataTools.tidepoolProcessor(processorConfig))
        .pipe(dataTools.xlsxStreamWriter(res, processorConfig));
    } else {
      // export as csv
      res.attachment('TidepoolExport.csv');
      res.write(CSV.stringify(dataTools.allFields));

      dataResponse.data
        .pipe(dataTools.jsonParser())
        .pipe(dataTools.tidepoolProcessor(processorConfig))
        .pipe(es.mapSync(
          (data) => CSV.stringify(dataTools.allFields.map(
            (field) => {
              if (data[field] === undefined || data[field] === null) {
                return '';
              }
              return data[field];
            },
          )),
        ))
        .pipe(res);
    }

    // Create a timeout timer that will let us cancel the incoming request gracefully if
    // it's taking too long to fulfil.
    const timer = setTimeout(() => {
      res.emit('timeout', config.exportTimeout);
    }, config.exportTimeout);

    // Wait for the stream to complete, by wrapping the stream completion events in a Promise.
    try {
      await new Promise((resolve, reject) => {
        dataResponse.data.on('end', resolve);
        dataResponse.data.on('error', (err) => reject(err));
        res.on('error', (err) => reject(err));
        res.on('timeout', async () => {
          statusCount.inc({ status_code: 408, export_format: exportFormat });
          reject(new Error('Data export request took too long to complete. Cancelling the request.'));
        });
      });
      statusCount.inc({ status_code: 200, export_format: exportFormat });
      log.debug(`Finished downloading data for User ${req.params.userid}`);
    } catch (e) {
      log.error(`Error while downloading: ${e}`);
      // Cancel the writeStream, rather than let it close normally.
      // We do this to show error messages in the downloaded files.
      writeStream.cancel();
      cancelRequest.cancel('Data export timed out.');
    }

    clearTimeout(timer);
  } catch (error) {
    if (error.response && error.response.status === 403) {
      statusCount.inc({ status_code: 403, export_format: exportFormat });
      res.status(error.response.status).send('Not authorized to export data for this user.');
      log.error(`${error.response.status}: ${error}`);
    } else {
      statusCount.inc({ status_code: 500, export_format: exportFormat });
      res.status(500).send('Server error while processing data. Please contact Tidepool Support.');
      log.error(`500: ${error}`);
    }
  } finally {
    nExportInProgress -= 1;
  }
});

function beforeShutdown() {
  if (nExportInProgress < 1) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // Ensure that the export request can time out
    // without being forcefully killed
    const timeout = config.exportTimeout + 10000;
    log.info(`${nExportInProgress} export in progress, shutting down in ${timeout}ms`);
    setTimeout(resolve, timeout);
  });
}

function onShutdown() {
  log.info('Server is shutting down');
}

function healthCheck() {
  return Promise.resolve();
}

const options = {
  healthChecks: {
    '/export/status': healthCheck,
  },
  signals: ['SIGTERM', 'SIGINT'],
  beforeShutdown,
  onShutdown,
};

if (config.httpPort) {
  const server = http.createServer(app);
  createTerminus(server, options);
  server.listen(config.httpPort, () => {
    log.info(`Listening for HTTP on ${config.httpPort}`);
  });
}

if (config.httpsPort) {
  if (_.isEmpty(config.httpsConfig)) {
    log.error('SSL endpoint is enabled, but no valid config was found. Exiting.');
    process.exit(1);
  } else {
    const server = https.createServer(config.httpsConfig, app);
    createTerminus(server, options);
    server.listen(config.httpsPort, () => {
      log.info(`Listening for HTTPS on ${config.httpsPort}`);
    });
  }
}
