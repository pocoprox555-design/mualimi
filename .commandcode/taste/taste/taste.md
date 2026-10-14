# Taste
- Communicates in Arabic (Gulf dialect) and expects replies in Arabic. Confidence: 0.8
- Reports UI/visual bugs by attaching screenshots of the running app alongside a short description; expects concrete fixes, not just explanations. Confidence: 0.7
- Detail-oriented about mobile/responsive layout polish (e.g., top-bar icon order and corner alignment in mobile view). Confidence: 0.7
- Prefers minimal, non-intrusive UI feedback — short status lines in-place rather than verbose error messages; explicitly dislikes "annoying" long text blocks. Confidence: 0.85
- Wants elegant, professional animation effects (fade, pulse, slide) for UI state transitions — values polished motion design. Confidence: 0.8
- Strong preference for automatic resource cleanup: all connections, timers, streams, and executions must close automatically when work completes — no manual intervention. Confidence: 0.85
- When multiple independent tasks exist, prefers delegating them to parallel background agents rather than handling sequentially. Confidence: 0.9
- Prefers resilient retry logic with generous retry counts (e.g., 10) and exponential/increasing backoff between attempts, rather than few retries with fixed delays. Confidence: 0.8
