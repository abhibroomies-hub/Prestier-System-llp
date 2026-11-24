# Security Specification — Prestier System LLP Firestore Rules

## 1. Data Invariants
1. **Default Deny**: All unmatched paths under `/databases/{database}/documents` are denied for both read and write.
2. **PII Isolation**: Customer leads (`/leads/{leadId}`) contain phone numbers and names (PII). `get`, `list`, and `delete` on `/leads/{leadId}` are strictly restricted to verified Admins (`isAdmin()`). Unauthenticated visitors or non-admin users can NEVER read or list other customers' leads.
3. **Draft Ownership & Terminal State Locking**:
   - A public visitor can `create` a lead document with a valid ID (`isValidId(leadId)`), a `sessionToken` (`>= 12` chars), strict field allowlist (`hasOnly`), field size limits, and `createdAt == request.time && updatedAt == request.time`.
   - A public visitor can `update` their own active `partial` lead ONLY if `existing().status == 'partial'` AND `incoming().sessionToken == existing().sessionToken` AND immutable fields (`leadId`, `sessionToken`, `createdAt`) do not change.
   - Once a lead reaches `status == 'confirmed'`, public updates are locked (`Terminal State Locking`). Only a verified Admin (`isAdmin()`) may update or delete a confirmed lead or toggle `sheetSynced`/`whatsappSent`.
4. **Admin Bootstrap & Email Verification**:
   - `isAdmin()` requires `request.auth != null && request.auth.token.email_verified == true` AND either `exists(/databases/$(database)/documents/admins/$(request.auth.uid))` or `request.auth.token.email == 'abhibroomies@gmail.com'`.
   - `/admins/{adminUid}` is read-only for the owner/admin and non-writable by non-admins to prevent self-assigned role escalation.
5. **Settings Isolation**:
   - `/settings/{settingId}` (Google Sheets configuration) is readable and writable strictly by `isAdmin()`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated PII Read (`get /leads/lead_01`)**: Rejected (`PERMISSION_DENIED`) — only verified Admin can read.
2. **Unauthenticated PII Scrape (`list /leads`)**: Rejected (`PERMISSION_DENIED`) — only verified Admin can list.
3. **Shadow Field Injection on Create (`isVerified: true`)**: Rejected by `data.keys().hasOnly(...)`.
4. **ID Poisoning (`leadId` with 200+ chars or invalid chars)**: Rejected by `isValidId(leadId)`.
5. **Value Poisoning (oversized `name` > 120 chars)**: Rejected by `data.name.size() <= 120`.
6. **Invalid Product Enum (`productInterest: 'Hacked Product'`)**: Rejected by enum check.
7. **Timestamp Forgery (`createdAt` != `request.time`)**: Rejected by temporal integrity rule.
8. **Session Hijack Update (mismatched `sessionToken`)**: Rejected by `incoming().sessionToken == existing().sessionToken`.
9. **Terminal State Bypass (public updating a `confirmed` lead)**: Rejected by `existing().status == 'partial'`.
10. **Immutable Field Tampering (changing `createdAt` or `leadId` on update)**: Rejected by immutability check + `affectedKeys().hasOnly(...)`.
11. **Admin Email Spoofing (`email == 'abhibroomies@gmail.com'`, `email_verified == false`)**: Rejected by `request.auth.token.email_verified == true`.
12. **Privilege Escalation (non-admin writing `/admins/{uid}` or `/settings/sheets`)**: Rejected by `isAdmin()`.
