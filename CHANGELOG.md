# Changelog

## 1.2.1

- Fixed: extension CSS no longer injected into non-GitLab pages (was breaking Jira UI due to class name collisions)

## 1.2.0

### Worklog improvements
- Worklogs are now sent immediately on button click, not after transitions complete — eliminates wait time on merge auto-triggers
- Added **Worklog Time Offset** setting (minutes) to shift worklog start time (e.g. `-120` = 2 h earlier)
- Worklog input field stays visible even when buttons are hidden by status filters, so time can be set before auto-trigger fires
- Minutes input resets to default after each button action

### Detailed notifications
- Toast now shows per-issue details: issue key, new status, and logged time instead of just a count
- Background returns per-issue `details[]` for both transitions and worklogs

### Settings UI overhaul
- Wider settings page (1200 px) — table fits without horizontal scroll
- Double-header table groups columns into categories: **Button**, **Jira Action**, **Visibility Filter**, **Auto-trigger**
- Vertical separators between column groups for visual clarity
- General tab split into **Jira Connection** and **Options** sections
- Username / Password fields side-by-side; connection status moved next to credentials

## 1.1.0

- Configurable buttons with transition name, color, worklog comment, visibility rules
- Auto-trigger on GitLab approve / merge / submit review actions
- Status pre-check with warning dialogs
- Test mode (block execution, log to console)
- Auto-open Jira tabs after action
- Worklog overlap prevention with free-slot search
