#!/bin/bash -eu
# Generate OpenAPI documentation
# $1 is package name
# $2 is package version

swagger-jsdoc -o doc/openapi/$1-$2-swagger.json -d swaggerDef.js app.js

# If this is not a release candidate but a "true" release, we consider this doc is the latest
# we create a copy named "latest" to be consumed by documentation website using SwaggerUI
if [[ $2 =~ [0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  mv doc/openapi/$1-$2-swagger.json doc/openapi/$1-latest-swagger.json
fi
