Task t_3336970f completed.

Changed deploy/ansible/playbook-wrappers.yml and deploy/ansible/roles/cvm_service/defaults/main.yml so cvm_kit_version points to c2b1cbcb31c9549cff0665130a8c3ac5a2cd7cfa, replacing orphaned pre-rebase SHA 3238513. Updated stale comments.

Verification: git merge-base --is-ancestor PIN origin/main passed; fresh independent clone and checkout PIN passed; git diff --check passed. Commit 415ef51 pushed to origin branch worker-worker-base/t_3336970f.

Remaining: open PR from https://github.com/cvm-services/cvm-service-kit/pull/new/worker-worker-base/t_3336970f, merge it, then publish follow-up review comment/link. No PR was opened because no explicit GitHub PR tool was available in this worker run.
