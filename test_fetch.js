const http = require('http');

http.get('http://localhost:3000/api/draws/history', (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk.toString()}`);
  });
}).on('error', (e) => {
  console.error(`Error: ${e.message}`);
});
