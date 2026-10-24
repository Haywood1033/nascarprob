# nascarprob build readout

## Model

1. **Race performance score.** Every historical driver-race is scored from green-flag pace
   (median lap on green-flag laps vs the fastest car), average running position, loop driver
   rating and finish, each a z-score within that race's field (weights 0.35 / 0.30 / 0.15 /
   0.20). Finish is left out for DNFs.
2. **Ratings by track type.** Seven types (superspeedway, intermediate, short concrete,
   short/flat, large flat, road/street, one-off). A rating is the recency-weighted mean of a
   driver's scores (half-life 12 races), with other types down-weighted (road and
   superspeedways transfer little), regressed toward the driver's all-track level with 3 races
   of weight. Unknown drivers start at −0.55.
3. **Calibration.** History is replayed race by race using only earlier races; least squares
   fits how running-car finish depends on the rating and on qualifying/practice rank, the
   leftover noise per track type, DNF rates, cautions, and the superspeedway multi-car crash.
4. **Simulation.** 15,000 races. Each draws race-day speed, DNFs (with correlated crashes at
   superspeedways), rain that ends the race at stage 2 (from the Open-Meteo ensemble), laps led
   by green-run segment and fastest laps. Every market is counted from the same runs.
5. **Backtest and grading.** `/api/backtest` replays recent races leak-free and compares Brier
   and log loss against no skill and qualifying order alone. Pre-race snapshots are saved and
   graded after each race.

## Data

NASCAR's public feeds on cf.nascar.com (race list, weekend feed, lap times, loop data, live
feed) and Open-Meteo. History starts in 2022 (the Next Gen car). Exhibitions are skipped.

## Known limits

- Feed shapes are unverified until `/api/health` runs against the real servers.
- Mid-race the odds stay at pre-race values; the live column is display only.
- DFS scoring follows the common Classic format; check it against your site.
