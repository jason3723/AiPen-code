import fs from 'fs';
const js = fs.readFileSync('dist/assets/index-C2BACZ1R.js', 'utf-8');

// Find createTutorialDocument - look for the console.log pattern
const patterns = [
  '教程文档已创建',
  '教程内容为空',
  '教程存在但内容为空',
  '教程文档存在但内容',
  'aipen_last_version',
];
for (const p of patterns) {
  const idx = js.indexOf(p);
  if (idx >= 0) {
    console.log(`"${p}" at ${idx}`);
    console.log(js.substring(idx - 200, idx + 300));
    console.log('---');
  } else {
    console.log(`"${p}" NOT FOUND`);
  }
}
