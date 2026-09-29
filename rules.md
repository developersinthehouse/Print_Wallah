### 3. `rules.md` (Coding Standards & Guidelines - Stream 1)

```markdown
# Coding Standards & Boundaries: Stream 1
**Focus:** Customer Upload Safety, Direct UPI Logic, and API Reliability

## Guidelines & Rules
1. **Strict Input Validation:** Validate file extensions on both frontend and backend. Only allow `.pdf`, `.png`, `.jpg`, `.jpeg`. Reject executable or unauthorized files instantly with a `400 Bad Request`.
2. **Zero Centralized Money Retention:** Never store or route customer payments through developer accounts. All intent strings must dynamically pull the respective shop's registered VPA (`pa`) parameter.
3. **Data Privacy Compliance:** Customer files must have a short lifespan on disk. Implement auto-deletion routines post-print execution to maintain total user privacy.
4. **Error Handling & Feedback:**
   * Frontend: Show clean, responsive loader states during file parsing and payment verification.
   * Backend: Return standardized JSON responses (`{ success: false, message: '...' }`) for any execution errors.
5. **Naming Conventions:** Use strict `camelCase` for JavaScript variables and function names, and `kebab-case` for file naming conventions.
