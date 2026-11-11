# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation

## Purpose

PDF Suite releases for Windows are intended to be signed with a certificate issued to SignPath Foundation. The signature shows that the file was built from this project's source code by the project's release process and was approved by a team member. The publisher shown on the signed files is SignPath Foundation.

Until signing is approved, the first releases are not code-signed. The release notes explain how to run them.

## What is signed

- The PDF Suite program files and installers built by this project from its own source code.
- Version and product name information in the signed program files is set to PDF Suite.

Third-party components included in PDF Suite are not signed under this project's signing.

## Team roles

Each signed release has these roles. One person may hold all of them.

| Role | Who | Responsibility |
|---|---|---|
| Author | Project maintainer | Writes the code and proposes releases. |
| Reviewer | Project maintainer | Reviews changes before a release is made. |
| Approver | Project maintainer | Approves each signing request in SignPath. |

Every team member uses multi-factor authentication on GitHub and on SignPath.

## Build and signing process

- Releases are built by GitHub Actions from source code, from a version tag.
- Each signing request must be approved by the approver before a file is signed.

## Privacy

PDF Suite does not send any data anywhere. It makes no network connections, except when you click a link in the app or in the documentation, which opens in your browser.

## Contact

Please open an issue on GitHub: https://github.com/karthikbhaskar-1/pdf-suite/issues
