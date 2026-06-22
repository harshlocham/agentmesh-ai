---
"@chat/auth": patch
"@chat/web": patch
---

Fix authentication and step-up flows:

- @chat/auth: Block token refresh while a session is step_up_pending so challenges stay valid through verification
- @chat/web: Reset auth bootstrap after login, register, and step-up completion
- @chat/web: Prevent duplicate refresh and OTP send requests that caused 429 rate limits
- @chat/web: Handle unauthenticated API calls without throwing after bootstrap