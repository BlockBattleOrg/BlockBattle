# Security Policy

## Overview
BlockBattle.org is built with privacy, security, and transparency as core principles.  
We take all necessary steps to protect sensitive information, ensure anonymous participation, and maintain public trust.

---

## 🔐 Privacy & Anonymity
- All commits to this repository are made using a **GitHub `noreply` email address**.
- Personal data of participants is **never** collected or stored.
- All cryptocurrency addresses are public and dedicated solely to this project.
- The platform does not require user accounts or personal identification for participation.

---

## 🛡 Data Protection
- All sensitive keys (API keys, private keys, connection strings) are stored in **environment variables** and are **never committed** to the repository.
- All database connections use **TLS encryption**.
- Supabase Row-Level Security (RLS) is enforced for all tables.
- Public API routes expose only aggregated, non-sensitive data.

---

## 🔍 Transparency
- All wallet addresses and aggregation logic are **publicly available** in this repository.
- The ingestion and aggregation code is open-source for audit by the community.
- All contributions are recorded **directly from the blockchain** to ensure verifiable data.

---

## 📢 Reporting a Vulnerability
If you discover a security issue:
1. **Do not** open a public GitHub issue.
2. Email us securely at: **blockbattle@proton.me**
3. Include:
   - Description of the issue
   - Steps to reproduce
   - Potential impact
   - Suggested mitigation (if available)

We aim to respond within **48 hours** and, if valid, will work to patch the vulnerability as quickly as possible.

---

## 🔄 Security Updates
Security-related updates and patches will be:
- Committed to `main` branch
- Documented in `CHANGELOG.md`
- Announced on the project’s official communication channels
