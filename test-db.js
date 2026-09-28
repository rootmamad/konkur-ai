const postgres = require('postgres');
const client = postgres('postgresql://konkur_app:change-me-to-a-strong-password@127.0.0.1:5432/konkur_ai');
client`SELECT 1`.then(r => console.log('DB OK:', r)).catch(e => console.error('DB Error:', e.message)).finally(() => client.end());