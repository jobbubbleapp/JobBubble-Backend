const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const atsPath = path.join(root, 'providers', 'ats.js');
const serverPath = path.join(root, 'server.js');
let ats = fs.readFileSync(atsPath, 'utf8');
let server = fs.readFileSync(serverPath, 'utf8');

const oldBlock = `async function fetchLeverBoard(board, signal) {\n  const jobs = [];\n  const pageSize = 100;\n  let skip = 0;\n\n  // Cap each board so a misconfigured feed cannot monopolize a JobBubble search.\n  while (skip < 1000) {`;
const newBlock = `async function fetchLeverBoard(board, signal) {\n  const jobs = [];\n  // V9.4.50: Lever accepts up to 1,000 postings in one public-API response. The\n  // previous 100-item page size forced large hourly-job boards through as many as\n  // ten sequential round trips and could hit the shared 12-second provider timeout.\n  // Keep the existing 1,000-job safety cap, but request the whole capped set at once.\n  const pageSize = 1000;\n  let skip = 0;\n\n  // Cap each board so a misconfigured feed cannot monopolize a JobBubble search.\n  while (skip < 1000) {`;
if (!ats.includes(newBlock)) {
  if (!ats.includes(oldBlock)) throw new Error('Step 6 Lever pagination target missing');
  ats = ats.replace(oldBlock, newBlock);
}
if (!ats.includes('const pageSize = 1000;')) throw new Error('Step 6 page size was not applied');
if (ats.includes('const pageSize = 100;')) throw new Error('Old 100-item Lever page size remains');

server = server.replaceAll('9.4.49', '9.4.50');
if (!server.includes('version: "9.4.50"')) throw new Error('Step 6 health version missing');
if (!server.includes('JobBubble backend V9.4.50 listening')) throw new Error('Step 6 startup version missing');

fs.writeFileSync(atsPath, ats, 'utf8');
fs.writeFileSync(serverPath, server, 'utf8');
console.log('Applied backend V9.4.50 fast Lever ATS pagination');
