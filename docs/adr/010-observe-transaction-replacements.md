# 010: Observe active transaction replacements without restoring signing authority

A wallet can reprice or cancel a submitted transaction. Waiting only for its original hash can leave the interface pending or misclassify a successful replacement as success of a different business call.

Use viem's replacement-aware receipt observation for active transactions, and pass its observations to the extracted transaction model. The model distinguishes the same call, cancellation and a different call. An earlier confirmed approval remains confirmed when a later business call is cancelled.

Observation does not grant signing authority. Account or chain changes stop later signing, and refreshing a known pending transaction resumes observation only. Missing receipts remain unresolved rather than becoming synthetic failures.

The later historical nonce/block search and replacement archive were removed under [ADR 024](024-course-delivery-scope.md). They are not needed for this active-operation decision.
