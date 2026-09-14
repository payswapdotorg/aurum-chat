# Aurum Longitudinal Learning Benchmark

Promoted from FINAL-HARDENING.txt (lock 2.1). Normative for W055/W056.

## Design

Run identical seeded companies with equivalent goals and information environments. The benchmark must compare an EXPERIENCED Aurum instance against a COLD-START Aurum instance on the same company. Improvement must arise from recorded CompanyModel updates only.

## Measurements at months 1, 3, 6, 12 and 24

1. consequential unknown discovery precision/recall;
2. median investigation steps per resolved mission;
3. first-choice source quality;
4. employee routing accuracy;
5. mission completion time and cost;
6. recommendation calibration;
7. intervention realized value versus expected value;
8. repeated-task performance improvement;
9. stale/contradictory evidence handling;
10. policy compliance and tenant isolation.

## Failure conditions

The benchmark FAILS if:
- policy is relaxed between runs;
- hidden facts are directly exposed to the reasoning layer (ground-truth leakage);
- provider-specific hidden state becomes authoritative;
- the experienced instance improves without recorded CompanyModel deltas attributable to evidence and outcomes.
