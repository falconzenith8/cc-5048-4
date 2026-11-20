// Node 入口：运行与浏览器共用的同一套断言（node src/tests.js）
import { readFileSync } from 'node:fs';
import { buildChecks } from './checks.js';
import { ECHO_HUNT_SPEC } from './exhibit-spec.js';

const checks = buildChecks();

// 仅 Node 侧：场景素材文件必须与单一真源逐字节一致，防止手工改动造成漂移
checks.push({
  group: '11 素材一致',
  name: 'scenes/echo-hunt.json 与 src/exhibit-spec.js 一致',
  run() {
    const onDisk = JSON.parse(readFileSync(new URL('../scenes/echo-hunt.json', import.meta.url), 'utf8'));
    if (JSON.stringify(onDisk) !== JSON.stringify(ECHO_HUNT_SPEC)) {
      throw new Error('场景文件与真源不一致，请运行 npm run build:exhibit:write');
    }
  },
});

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
