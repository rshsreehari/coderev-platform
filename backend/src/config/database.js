const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

// RDS requires SSL with certificate verification
let sslConfig = false;
if (isProduction) {
  const certPath = path.join(__dirname, '..', '..', 'certs', 'global-bundle.pem');
  if (fs.existsSync(certPath)) {
    sslConfig = {
      rejectUnauthorized: true,
      ca: fs.readFileSync(certPath).toString(),
    };
    console.log('🔒 SSL enabled with RDS certificate bundle');
  } else {
    // Fallback: trust AWS RDS CA (less secure but works)
    sslConfig = { rejectUnauthorized: false };
    console.log('⚠️  SSL enabled without cert file (rejectUnauthorized=false)');
  }
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: isProduction ? 15 : 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: isProduction ? 5000 : 2000,
  ssl: sslConfig,
});

pool.on('connect', () => {
  console.log(`Connected to PostgreSQL (${isProduction ? 'AWS RDS' : 'local'})`);
});

pool.on('error', (err) => {
  console.error('PostgreSQL error:', err);
  process.exit(-1);
});

module.exports = pool;