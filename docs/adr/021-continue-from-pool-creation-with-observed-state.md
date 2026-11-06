# 021: Continue from pool creation with observed state

Creating a pool confirms a transaction and a pool identity. It does not establish that the pool is still empty when the user next adds liquidity: another provider can act before the next observation.

The continuation therefore uses the confirmed exchange and pool identifier to select the matching currently observed pool. A loaded empty pool takes the first-deposit path; a funded pool takes proportional deposits. Missing observations ask for another read rather than substituting a same-numbered pool from another exchange or assuming zero reserves.

This keeps first-deposit price selection and later proportional deposits attached to the chain state used for preparation. The former generic historical creation-result reader was removed under [ADR 024](024-course-delivery-scope.md); the immediate creation continuation remains.
