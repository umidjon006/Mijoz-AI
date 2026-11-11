/**
 * FAQAT HARNESS. Ssenariy fayllarini tekshiradi va JSON Schema faylini yozadi.
 *
 *   npm run scenarios:check
 *
 * Yaroqsiz fayl bo'lsa — aniq xabar va kod 1. Schema:
 * harness/scenarios/scenario.schema.json (muharrirda "$schema" sifatida).
 */
import './env.js';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_JSON_SCHEMA } from '../../module/backend/src/training/scenario/json-schema.js';
import { contentFlag, effectiveBehavior } from '../../module/backend/src/training/scenario/schema.js';
import { loadScenarioFiles, scenariosDir } from './scenarios.js';

const schemaPath = join(scenariosDir, 'scenario.schema.json');
writeFileSync(schemaPath, `${JSON.stringify(SCENARIO_JSON_SCHEMA, null, 2)}\n`);
console.log(`JSON Schema: ${schemaPath}`);

const { valid, errors } = loadScenarioFiles();
for (const { file, scenario } of valid) {
  const b = effectiveBehavior(scenario);
  const flag = contentFlag(scenario);
  console.log(
    `ok   ${file}: ${scenario.title_uz} · qiyinlik ${scenario.difficulty} · insult ${b.insultLevel} · sarcasm ${b.sarcasm}` +
      ` · sen ${b.allowSen ? 'mumkin' : "yo'q"}${flag.harsh ? ' · OGOHLANTIRISH' : ''}${b.capped.length ? ` · cheklandi: ${b.capped.join(', ')}` : ''}`,
  );
}
for (const e of errors) console.error(`RAD  ${e}`);
console.log(`\n${valid.length} ta yaroqli, ${errors.length} ta xato.`);
if (errors.length > 0) process.exit(1);
