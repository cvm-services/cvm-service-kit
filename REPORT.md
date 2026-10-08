Task t_3c048cb9 completed the repository-side ngit-CI lane but is blocked on coordinator operations.

Completed:
- Added .ngit/act/workflows/ci.yml with Bun and Deno jobs, pinned action SHAs, and required commands.
- Added .ngit/README.md documenting that the coordinator runs .ngit/act/workflows/ only.
- Commit 9ee9ab1 pushed as pr/ngit-ci-lane.
- GitHub PR #10 merged; main head is feb3358c9e9e98f538ca5181b1bfd77a8c3ab87f.
- Pushed the identical head to the ngit mirror; output confirmed 29a3421..feb3358 on main.

Blocked:
- SSH to hermes-nvme (debian@23.182.128.219, ~/.ssh/id_fleet) timed out at TCP connect, including a 10-second diagnostic. Therefore I could not back up/edit ~/ngit-ci-deploy/.env, verify DQ05 ownership, restart the coordinator, or run live ci_evidence. No success is claimed for those steps.

Exact failed command:
ssh -vv -o ConnectTimeout=10 -o BatchMode=yes -i ~/.ssh/id_fleet debian@23.182.128.219 true
Failure: connect to address 23.182.128.219 port 22: Connection timed out

Remaining:
1. Restore SSH/network access to hermes-nvme.
2. Back up .env, add cvm-service-kit only to hermes-nvme NGIT_CI_REPOS, and synchronize peer-owned-repos.txt after verifying DQ05 absence.
3. Reload/restart coordinator and record exact command.
4. Trigger/await run and execute evidence tool with --require-conclusion for head feb3358c9e9e98f538ca5181b1bfd77a8c3ab87f.
