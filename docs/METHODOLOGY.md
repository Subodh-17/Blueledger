# Carbon assessment methodology (`ILLUSTRATIVE-BC-v1`)

**Status: illustrative.** The software provides a transparent, reproducible calculation structure. The coefficients are placeholders carried over from earlier project code; no published source is attached to them. They must be replaced by a reviewed methodology before any claim is made outside this system.

## Formula
```
gross_total      = area_ha × rate[tCO2e/ha/yr] × crediting_years × survival_rate/100
net_total        = gross_total × (1 − 20% uncertainty) × (1 − 10% buffer)
new_estimate     = max(0, net_total − credits already issued for the project)
eligible_credits = floor(new_estimate)            (whole tonnes, never rounded up)
```
`crediting_years` = years from the project start date to the monitoring date, capped at 10. The range shown beside an estimate is a flat ±35% display band, not a statistical interval.

## Parameters
| Parameter | Value | Status |
|---|---|---|
| Mangrove / seagrass / salt-marsh rate | 6.0 / 1.38 / 2.18 tCO2e/ha/yr | Unvalidated placeholder |
| Uncertainty discount | 20% | Unvalidated placeholder |
| Buffer pool | 10% | Unvalidated placeholder |
| Maximum crediting years | 10 | Unvalidated placeholder |

## Quantities (kept distinct in the interface)
*Calculated* (net total for the monitoring date) → *Estimated* (incremental after prior issuance) → *Approved* (eligible whole tonnes after administrator approval) → *Issued* (on-chain batch).

## Data rules
A survival-rate measurement is required. **Missing data is never treated as zero**; a measured value of 0 is valid and yields 0 eligible credits. Calculations store inputs, parameters, results, an input hash, the methodology version, the assessment number and who/when; recalculation with identical inputs is reproducible (tested). Image or remote-sensing content is not an input.
The earlier calculator added a biomass stock to accumulated sequestration (double counting); that term was removed.

## Requires scientific or independent review
1. Applicable published methodology per habitat (mangrove, seagrass, salt marsh).
2. Source, range and uncertainty of sequestration coefficients, including soil carbon pools and emissions.
3. Baseline scenario, additionality and leakage.
4. Permanence, buffer size and governance.
5. Monitoring design: plots, sampling intensity, minimum frequency, measurement protocols, survival definitions.
6. Independent validation/verification procedures and verifier competence requirements.
7. Legal and regulatory treatment of any credit.
