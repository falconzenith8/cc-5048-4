// Node 入口：运行与浏览器共用的同一套断言（node src/tests.js）
import { buildChecks } from './checks.js';

const checks = buildChecks();
let passed = 0, group = '';
for (const c of checks) {
  if (c.group !== group) { group = c.group; console.log(`\n${group}`); }
  try {
    c.run();
    passed++;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} 项检查通过`);
if (process.exitCode) console.error('存在失败项');
