import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesSource = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');

test('firestore.rules enforces rules_version 2 and default-deny safety net', () => {
  assert.match(rulesSource, /rules_version\s*=\s*'2'/);
  assert.match(rulesSource, /match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;/);
});

test('firestore.rules enforces PII isolation and Dirty Dozen invariants', () => {
  // 1-2. Read/List restricted to verified admins
  assert.match(rulesSource, /allow\s+get:\s*if\s+isValidId\(leadId\)\s*&&\s*isAdmin\(\);/);
  assert.match(rulesSource, /allow\s+list:\s*if\s+isAdmin\(\);/);

  // 3-6. Strict schema validation helper with hasOnly and size limits
  assert.match(rulesSource, /data\.keys\(\)\.hasOnly\(/);
  assert.match(rulesSource, /data\.name\.size\(\)\s*<=\s*120/);
  assert.match(rulesSource, /isValidProductInterest\(data\.productInterest\)/);

  // 7-10. Temporal integrity, session token match, and terminal state locking
  assert.match(rulesSource, /incoming\(\)\.createdAt\s*==\s*request\.time/);
  assert.match(rulesSource, /incoming\(\)\.sessionToken\s*==\s*existing\(\)\.sessionToken/);
  assert.match(rulesSource, /existing\(\)\.status\s*==\s*'partial'/);

  // 11-12. Email verification required for admin
  assert.match(rulesSource, /request\.auth\.token\.email_verified\s*==\s*true/);
});
