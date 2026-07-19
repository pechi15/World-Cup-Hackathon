# Demo Runbook

Run locally:

```powershell
Set-Location "E:\Hackathons\World-Cup-cursor-integration"
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run dev
```

Frontend: http://localhost:5173

Backend: http://localhost:8787

Use **Run Full Demo** to reset the replay, start the deterministic scenario, create paper fills, and finish with settlement.

Failure recovery:

- Backend restart: refresh the browser and click Reset.
- Replay reset: click Reset, then Run Full Demo.
- Frontend refresh: state is restored from the backend replay engine.
- Missing backend URL: set `VITE_API_BASE_URL`.
- No live match or TxODDS credentials: replay mode does not require them.
