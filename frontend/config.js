// Where the backend API lives.
// After deploying the backend to Render, replace the production URL below.
const PRODUCTION_API_URL = 'https://test-wbtd.onrender.com';

const API_URL = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:3000'
  : PRODUCTION_API_URL;
