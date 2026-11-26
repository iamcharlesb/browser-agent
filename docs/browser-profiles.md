# Browser profiles

Use **Profiles: Default** in the top toolbar to create or switch named website-login sessions, such as Work, Personal or Client. Each named profile has its own Chrome user-data directory and local debugging endpoint. Sign in once per profile; returning to it reuses its cookies and persistent website storage. Chrome may still require reauthentication or MFA when a site expires a session.

The existing session remains **Default**, with its original configuration. Named profiles use dedicated managed Chrome sessions. Switching disconnects Pilo from the previous browser without closing its Chrome windows. Old screenshots, browser tabs and address text are cleared from Pilo so they are not presented as the new account. Open a website to connect the selected profile.

Switch only when tasks and queued work are idle. The server rejects switching while work is active and blocks task starts during the transition. No model request, login or website action is triggered by creating or selecting a profile.

Schedules are bound to the profile selected at creation (legacy schedules use Default). If another profile is selected when the schedule fires, it waits without starting a model. Its saved browser/outward permissions cannot be borrowed by a run in another profile.

These are browser login profiles, not separate Pilo users or bot workspaces. Bot conversations, model credentials and the Pilo application account remain shared. Bots receive the selected profile identity and must recheck account scope before using historical account observations. Profiles are local data, not an account-isolation or multi-tenant security boundary.

Profile names and selection persist in `.browser-agent-profiles/profiles.json` beneath Pilo's data directory. Named Chrome data is stored beneath that directory using generated IDs, never user-supplied file paths. `BROWSER_AGENT_MAX_BROWSER_PROFILES` controls the count and `BROWSER_AGENT_PROFILE_PORT_BASE` the local debugging-port range. Do not copy profile directories into Git; they contain login sessions. The default profile is preserved and there is no destructive profile-delete action.

For requests that explicitly name regular or external Chrome, Pilo can attach to an already running session via an operator-configured local debugging endpoint. Set `BROWSER_AGENT_EXTERNAL_CHROME_PROFILE` to the profile name and `BROWSER_AGENT_EXTERNAL_CHROME_ENDPOINT` to its loopback HTTP endpoint. Pair the endpoint with a Chrome instance dedicated to that profile. Pilo relies on this pairing to identify the profile. Chrome must expose one browser context with an open tab. Pilo does not launch Chrome, import cookies, or substitute a managed session when this connection is unavailable.
