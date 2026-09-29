---

### 3. `rules.md` (Coding Standards & Guidelines - Stream 2)

```markdown
# Coding Standards & Boundaries: Stream 2
**Focus:** Agent Resilience, Subscription Security, and Admin Access Control

## Guidelines & Rules
1. **Desktop Agent Fault Tolerance:** The Python print agent must implement exponential backoff retry logic. If the shop loses internet connectivity, the agent must catch exceptions gracefully without crashing or freezing the shopkeeper's PC.
2. **Strict Subscription Middleware Enforcement:** Every authenticated request from a shop dashboard or print agent must pass through the subscription verification middleware. Expired shops must be blocked immediately with a `403 Forbidden - Subscription Expired` response.
3. **Super Admin Authorization:** Master onboarding and global metrics endpoints must be strictly protected behind cryptographic tokens (JWT) or secure admin session keys.
4. **Error Handling & Logging:** 
   - Agent: Log local print failures or missing printers clearly to a local `agent.log` file.
   - Backend: Return structured JSON error states for expired subscriptions or invalid shop IDs.
5. **Naming Conventions:** Use `snake_case` for Python scripts, strict `camelCase` for JavaScript functions, and `PascalCase` for database schemas.