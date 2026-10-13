# Inference, serving & infra — syllabus

Markers: `[ ]` todo · `[>]` next · `[x]` taught · `[~]` skipped, mastered (cite the evidence date) · `[+]` inserted remedial

Telos may reorder lessons within a phase, split a lesson that won't fit in ~550 words, or insert remedial lessons. Phase order stays fixed unless Daniel asks to change it. Each line is the concept plus the question the lesson answers.

## Phase 1 — What inference computes
- [>] 1. One forward pass — tokens → embeddings → N blocks (attention + MLP) → logits. "Generate 100 tokens" = 100 sequential forward passes.
- [ ] 2. Sampling — logits → probabilities; greedy, temperature, top-k, top-p. Cheap, but it runs on the critical path every step.
- [ ] 3. Prefill vs decode — the prompt is processed in one parallel pass; output tokens come one at a time. Why these are two different workloads.
- [ ] 4. Latency vocabulary — TTFT, ITL/TPOT, end-to-end latency, throughput, goodput. Which one a voice-agent user actually feels.

## Phase 2 — The hardware mental model
- [ ] 5. A GPU for inference — HBM vs on-chip SRAM, SMs, tensor cores. The two numbers that matter: FLOP/s and memory bandwidth (H100 SXM: ~990 dense bf16 TFLOP/s, 3.35 TB/s).
- [ ] 6. Arithmetic intensity and the roofline — FLOPs per byte moved; compute-bound vs memory-bound; the ridge point (~300 FLOPs/byte on H100).
- [ ] 7. Why decode is memory-bound — batch-1 decode reads every weight once per token (~2 FLOPs per param ≈ 1 FLOP/byte at bf16). Upper bound: tokens/s ≈ bandwidth ÷ model bytes.
- [ ] 8. Why prefill is compute-bound — many tokens share each weight read. What that means for TTFT as prompts grow.

## Phase 3 — Memory: weights and the KV cache
- [ ] 9. Weight memory — params × bytes per param. 8B at bf16 = 16 GB; what fits on one 80 GB GPU.
- [ ] 10. The KV cache — what is cached (K and V for every past token, in every layer) and why: each decode step processes one new token instead of re-processing the whole sequence.
- [ ] 11. KV cache size — 2 × layers × kv_heads × head_dim × bytes per token. Llama-3-8B: 2 × 32 × 8 × 128 × 2 B = 128 KiB per token → 1 GiB per 8K-token sequence.
- [ ] 12. MHA → MQA → GQA → MLA — sharing or compressing K/V heads to shrink the cache; the quality vs memory trade.
- [ ] 13. The memory budget — weights + KV cache + activations. Why KV capacity, not compute, caps concurrent requests.

## Phase 4 — Batching and scheduling
- [ ] 14. Why batching helps decode — one weight read serves B requests; throughput climbs nearly linearly until compute- or KV-bound. The latency cost.
- [ ] 15. Static batching and its failure — padding, waiting for the longest request, head-of-line blocking.
- [ ] 16. Continuous batching (Orca, iteration-level scheduling) — requests join and leave the batch every step.
- [ ] 17. Chunked prefill — mixing prefill chunks with decodes in one step; the TTFT vs inter-token-latency trade it tunes.
- [ ] 18. Preemption — what happens when KV memory runs out mid-generation (recompute vs swap); scheduling policies (FCFS, priority).

## Phase 5 — Managing KV memory
- [ ] 19. Fragmentation — why reserving max_seq_len per request wastes most of KV memory.
- [ ] 20. PagedAttention — fixed-size blocks + block tables, the OS virtual-memory analogy; near-zero waste.
- [ ] 21. Prefix caching — reusing KV for shared prefixes (system prompts, multi-turn history). vLLM's block-hash prefix caching vs SGLang's RadixAttention.
- [ ] 22. KV offload and tiering — CPU, SSD, or remote KV stores (e.g. LMCache); why long multi-turn voice sessions make this interesting.

## Phase 6 — Kernels
- [ ] 23. Naive attention's cost — the n × n score matrix and the HBM traffic it causes.
- [ ] 24. FlashAttention — tiling + online softmax so the score matrix never touches HBM; IO-awareness.
- [ ] 25. Decode attention — FlashDecoding / split-KV, FlashInfer; why decode attention needs different kernels than prefill.
- [ ] 26. Launch overhead, kernel fusion, CUDA graphs — why small-batch decode is CPU/launch-bound without them.

## Phase 7 — Doing less work
- [ ] 27. Quantization basics — weight-only vs weight + activation; INT8, FP8, INT4. Why weight-only quantization helps memory-bound decode.
- [ ] 28. GPTQ and AWQ — how 4-bit weights keep quality (calibration, activation-aware scaling).
- [ ] 29. FP8 inference and KV-cache quantization — what H100-class hardware gives you.
- [ ] 30. Speculative decoding — draft, then verify in one pass; why it's lossless; why it only pays off in the memory-bound regime.
- [ ] 31. Speculative variants — n-gram / prompt lookup, Medusa, EAGLE; acceptance rate as the metric that matters.

## Phase 8 — Scaling out
- [ ] 32. Tensor parallelism — splitting matmuls across GPUs; the per-layer all-reduce and why it wants NVLink.
- [ ] 33. Pipeline and expert parallelism — layers across GPUs; MoE routing and the expert-parallel all-to-all.
- [ ] 34. Disaggregated prefill/decode — separate pools for the two workloads (DistServe, Splitwise, Mooncake); the KV-transfer cost.
- [ ] 35. Routing across replicas — load balancing vs KV/prefix-aware routing (e.g. llm-d, NVIDIA Dynamo).

## Phase 9 — Engines and operating them
- [ ] 36. vLLM architecture tour — API server → engine core → scheduler → KV cache manager → workers.
- [ ] 37. SGLang architecture tour — what it does differently (radix cache, scheduler, frontend language).
- [ ] 38. Benchmarking honestly — request rate vs concurrency, open vs closed loop, percentile latency, goodput under an SLO.
- [ ] 39. The tuning knobs — max_num_seqs, max_num_batched_tokens, gpu_memory_utilization, chunked prefill, prefix caching: what each one trades.
- [ ] 40. Serving for realtime voice — TTFT-first SLOs, streaming, priority scheduling, prefix-caching conversation history; the bridge back to your engine.

## Phase 10 — Serving infrastructure
- [ ] 41. Model loading and cold starts — weights from disk/network into GPU memory; why scale-from-zero breaks a realtime latency budget.
- [ ] 42. Autoscaling GPU inference — which signal to scale on (queue depth, KV-cache utilization, TTFT) and why CPU or requests/s mislead.
- [ ] 43. Long-lived streaming connections — load-balancing WebSocket/WebRTC sessions, sticky routing, draining connections on deploy.
- [ ] 44. Observability for latency SLOs — percentiles, per-stage timing (queue → prefill → decode → network), tracing one turn end to end.
- [ ] 45. Where latency hides end to end — network RTT, region placement, edge vs central GPUs; building the latency budget for one voice turn.
