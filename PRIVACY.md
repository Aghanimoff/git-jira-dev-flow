Privacy Policy for Git&Jira deroutine Dev Flow
=============================================

Last updated: February 6, 2026

## Data Collection

Git&Jira deroutine Dev Flow does NOT collect, transmit, or share any personal data or browsing activity with third parties.

## Data Storage

The extension stores the following data locally on your device using Chrome's `chrome.storage.local` API:

- Jira Base URL
- Jira username
- Jira password or API token
- User preferences (worklog tracking, auto-open settings)

This data never leaves your browser except to communicate directly with your configured Jira instance.

## Network Communication

The extension makes HTTP requests only to:

- **Your Jira instance** (the URL you configure in settings) — to perform issue transitions and log worklogs

No data is sent to any other server, analytics service, or third party.

## Permissions

- `storage` — to save your Jira credentials and preferences locally
- `activeTab` — to read the current GitLab MR page content
- `host_permissions: <all_urls>` — to communicate with your self-hosted Jira instance (URL varies per user)

## Contact

For questions about this privacy policy, open an issue on the project's GitHub repository.
