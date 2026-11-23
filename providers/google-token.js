const { shareInFlight } = require('../lib/shared-operation');

function createGoogleTokenSource(credentialsFile, getAccessToken) {
  let auth;
  return shareInFlight(getAccessToken || (() => {
    const { GoogleAuth } = require('google-auth-library');
    auth ||= new GoogleAuth({ keyFilename: credentialsFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    return auth.getAccessToken();
  }));
}
module.exports = { createGoogleTokenSource };
