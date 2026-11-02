# Dashboard patch workflow

- Keep the current release version unless the user explicitly requests a version increase. A patch must not bump `VERSION` or the displayed release number.
- Keep `/test-server/` as the ongoing staging page. The production footer must not link to it unless the user asks to restore that button.
- Before implementing a future dashboard patch, show the information notice `#maintenance-notice` in `dist/test-server/index.html` by removing its `hidden` attribute. Publish this state and verify the notice on the live test page before continuing the patch.
- Use the test page to validate changes. Run the relevant existing checks and verify the requested behavior and responsive layout. Do not modify real experiment or parcel records for testing.
- After the requested patch is deployed and all relevant checks and live verification pass, add `hidden` to `#maintenance-notice`, publish that change, and confirm the notice is hidden. Keep the notice visible while any failure or verification remains unresolved.
- Retain the notice markup and its stylesheet when hiding it so it can be reused. The current notice was explicitly requested as a visible addition; the enable-before/hide-after cycle applies to subsequent patches.
