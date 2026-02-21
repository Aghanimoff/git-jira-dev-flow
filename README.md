# Git&Jira deroutine Dev Flow

Chrome extension that streamlines developer workflow between GitLab and Jira.

## Features

- **One-click Jira status update** - from GitLab MR pages (Code review / Releases)
![Extension buttons on MR page](docs/screenshot-button-1.png)
- **Automatic worklog tracking** - distributes time across linked issues
![Release button with worklog](docs/screenshot-button-2.png)
- **Smart time rounding** - worklog is rounded up to the 5 minutes
- **Worklog overlap prevention** - searching for existing worklogs and adjusting new worklog separately
- **Status pre-check** - warns you if issues are already in the target status

## Setup
1. Install Chrome extension from [Chrome Web Store (Will be later maybe)](https://chromewebstore.google.com/detail/TODO) or load unpacked from source
2. Open extension settings and configure your Jira instance URL, username, or API token  
![Settings page](docs/screenshot-settings.png)

3. Configure buttons on the **Buttons** tab — transitions, visibility filters, and auto-triggers
![Button settings](docs/screenshot-settings-buttons.png)

## More information in tooltips
![Tooltip with issue details](docs/screenshot-tooltip.png)

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.
