@Library('mdblp-library') _
pipeline {
    agent any
    stages {
        stage('Initialization') {
            steps {
                script {
                    utils.initPipeline()
                    if(env.GIT_COMMIT == null) {
                        // git commit id must be a 40 characters length string (lower case or digits)
                        env.GIT_COMMIT = "f".multiply(40)
                    }
                    env.RUN_ID = UUID.randomUUID().toString()
                }
            }
        }
        stage('Build') {
            agent {
                docker {
                    image "docker.ci.diabeloop.eu/node-build:12"
                }
            }
            steps {
                withCredentials([string(credentialsId: 'nexus-token', variable: 'NEXUS_TOKEN')]) {
                    sh "npm install -g npm@6"
                    sh "npm run build-ci"
                }
            }
        }
        stage('Package') {
            steps {
                withCredentials([string(credentialsId: 'nexus-token', variable: 'NEXUS_TOKEN')]) {
                    pack()
                }
            }
        }
        stage('Documentation') {
            steps {
                genDocumentation()
            }
        }
        stage('Publish') {
            when { branch "dblp" }
            steps {
                publish()
            }
        }
    }
}
