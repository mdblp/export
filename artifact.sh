#!/bin/sh -e

wget -q -O artifact_node.sh 'https://raw.githubusercontent.com/mdblp/tools/dblp/artifact/artifact_node.sh'
chmod +x artifact_node.sh

. ./version.sh
npm install --save-dev "ci-toolbox@latest"
BUILD_SOUP="true" ./artifact_node.sh
