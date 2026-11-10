# perf(time): cache `Intl.DateTimeFormat` v `getLocalHourAndMinute` (~70× rýchlejší layout kalendára)

## Zhrnutie

Časová (CPU) profilácia rozloženia udalostí v plánovacom kalendári (Day/Week view) ukázala,
že **86 % času** behu zaberá funkcia `getLocalHourAndMinute` zo [src/lib/time.ts](../../../src/lib/time.ts).
Funkcia pri **každom volaní vytvárala dve nové inštancie `Intl.DateTimeFormat`**:

1. v `isValidIanaTimezone` iba kvôli overeniu, či je časové pásmo platné,
2. samotný formátovač hodín a minút.

Konštrukcia `Intl.DateTimeFormat` je drahá operácia (načítanie ICU dát o lokalizácii a časovom pásme),
pričom jej výsledok je pre rovnaké časové pásmo vždy rovnaký. Úprava preto:

- **memoizuje výsledok `isValidIanaTimezone`** pre každý identifikátor časového pásma,
- **znovupoužíva jeden formátovač hodín/minút pre každé časové pásmo** (inštancie `Intl.DateTimeFormat` sú nemenné, takže ich zdieľanie je bezpečné),
- obe cache sú **ohraničené** (max. 1000 položiek, IANA pásiem je ~600), takže ľubovoľný vstup od používateľa ich nemôže nekonečne zväčšovať.

Výsledok rozloženia je bitovo rovnaký (rovnaký kontrolný súčet), mení sa iba čas vykonávania:
**258,96 ms → 3,72 ms na jedno vykreslenie týždňa (≈ 69,6× rýchlejšie, −98,6 %).**

## Typ profilácie a nástroj

- **Typ:** časová (CPU) profilácia.
- **Nástroj:** vstavaný vzorkovací profiler V8 v Node.js (`node --cpu-prof`). Nevyžaduje
  žiadnu inštaláciu, je open source a beží lokálne bez odosielania dát. Výsledný súbor
  `.cpuprofile` sa dá otvoriť aj v Chrome DevTools (karta *Performance*) alebo na speedscope.app.
- **Textový výstup:** [scratch/summarize-cpuprofile.mjs](../../../scratch/summarize-cpuprofile.mjs)
  (bez závislostí) zo súboru `.cpuprofile` vypíše najdrahšie funkcie podľa *self* a *total* času.

## Scenár merania

Automatizovaný a deterministický skript [scratch/profile-calendar-layout.ts](../../../scratch/profile-calendar-layout.ts)
simuluje vykreslenie týždenného plánovača:

- 7 dní × 40 udalostí, generovaných seedovaným PRNG (mulberry32, seed 42), takže každý beh pracuje s rovnakými dátami,
- časové pásmo `Europe/Bratislava`,
- jedno „vykreslenie týždňa“ = `computeTimelineRange` pre celý týždeň + `layoutHorizontalEvents`
  a `layoutVerticalEvents` pre každý deň, teda **2 240 volaní `getLocalHourAndMinute`**,
- 20 zahrievacích iterácií (JIT) sa do merania nezapočítava,
- meranie: 5 behov × 20 vykreslení týždňa, `process.hrtime.bigint()`, porovnáva sa **medián**,
- kontrolný súčet výstupu overuje, že sa výsledok rozloženia nezmenil.

Spustenie:

```bash
# benchmark (iterácie na beh, počet behov)
node node_modules/jiti/lib/jiti-cli.mjs scratch/profile-calendar-layout.ts 20 5

# CPU profil + textový súhrn
node --cpu-prof --cpu-prof-dir=profiles node_modules/jiti/lib/jiti-cli.mjs scratch/profile-calendar-layout.ts 10 3
node scratch/summarize-cpuprofile.mjs profiles/<súbor>.cpuprofile
```

Prostredie: macOS (Darwin 25.6), Node.js v26.8.1.

## Nájdený bottleneck (pred úpravou)

Celý výstup: [before.txt](before.txt)

```text
$ node node_modules/jiti/lib/jiti-cli.mjs scratch/profile-calendar-layout.ts 20 5
Scenario: 7 days x 40 events, 20 week renders per run, 5 runs (tz Europe/Bratislava)
getLocalHourAndMinute calls per week render: 2240
Runs (ms): 5155.3, 5179.3, 4900.1, 5943.0, 5562.2
Median: 5179.3 ms per run  |  Mean: 5348.0 ms per run
Median per week render: 258962.7 µs
Heap used after run: 18.2 MB
Checksum: 228400

$ node scratch/summarize-cpuprofile.mjs before.cpuprofile
Profile: before.cpuprofile  |  sampled time: 13198.1 ms  |  samples: 10256

Top functions by SELF time
ms        %       function
6373.6    48.3%   getLocalHourAndMinute  src/lib/time.ts:484
4940.6    37.4%   isValidIanaTimezone  src/lib/time.ts:38
792.2     6.0%    (program)
766.4     5.8%    flushCluster  src/features/calendar/layout.ts:310
112.3     0.9%    (garbage collector)
...

Top project functions by TOTAL (inclusive) time
ms        %       function
11330.9   85.9%   getLocalHourAndMinute  src/lib/time.ts:484
6852.9    51.9%   computeTimelineRange  src/features/calendar/layout.ts:35
4940.6    37.4%   isValidIanaTimezone  src/lib/time.ts:38
4688.3    35.5%   layoutHorizontalEvents  src/features/calendar/layout.ts:94
3371.3    25.5%   layoutVerticalEvents  src/features/calendar/layout.ts:248
...
```

Interpretácia: samotná logika rozloženia (triedenie, prideľovanie pruhov/stĺpcov) je zanedbateľná.
Takmer celý čas sa minie v natívnom konštruktore `Intl.DateTimeFormat`. Profiler ho pripisuje
volajúcim funkciám `getLocalHourAndMinute` (48,3 % self) a `isValidIanaTimezone` (37,4 % self).
Jedno volanie `getLocalHourAndMinute` trvalo približne 115 µs.

## Po úprave

Celý výstup: [after.txt](after.txt)

```text
$ node node_modules/jiti/lib/jiti-cli.mjs scratch/profile-calendar-layout.ts 20 5
Scenario: 7 days x 40 events, 20 week renders per run, 5 runs (tz Europe/Bratislava)
getLocalHourAndMinute calls per week render: 2240
Runs (ms): 75.5, 76.7, 74.4, 73.8, 73.3
Median: 74.4 ms per run  |  Mean: 74.8 ms per run
Median per week render: 3719.3 µs
Heap used after run: 19.1 MB
Checksum: 228400

$ node scratch/summarize-cpuprofile.mjs after.cpuprofile
Profile: after.cpuprofile  |  sampled time: 421.5 ms  |  samples: 386

Top functions by SELF time
ms        %       function
170.2     40.4%   getLocalHourAndMinute  src/lib/time.ts:501
22.6      5.4%    (garbage collector)
18.9      4.5%    isValidIanaTimezone  src/lib/time.ts:43
12.7      3.0%    (idle)
12.6      3.0%    __webpack_require__  babel.cjs:242
...

Top project functions by TOTAL (inclusive) time
ms        %       function
197.8     46.9%   getLocalHourAndMinute  src/lib/time.ts:501
119.2     28.3%   computeTimelineRange  src/features/calendar/layout.ts:35
113.9     27.0%   layoutHorizontalEvents  src/features/calendar/layout.ts:94
37.4      8.9%    layoutVerticalEvents  src/features/calendar/layout.ts:248
18.9      4.5%    isValidIanaTimezone  src/lib/time.ts:43
...
```

Po úprave zostáva v `getLocalHourAndMinute` už iba volanie `formatToParts`. V profile sa navyše
objavujú položky z `babel.cjs` a `readFileUtf8`, čo je jednorazová transpilácia TypeScriptu
nástrojom jiti pri štarte. Pred úpravou bola voči 13 s behu zanedbateľná.

## Porovnanie

| Metrika (medián z 5 behov) | Pred | Po | Zmena |
| --- | ---: | ---: | ---: |
| Čas na 1 vykreslenie týždňa (280 udalostí) | 258,96 ms | 3,72 ms | **≈ 69,6× rýchlejšie (−98,6 %)** |
| Čas na 1 beh (20 vykreslení) | 5 179,3 ms | 74,4 ms | −98,6 % |
| Priemerný čas 1 volania `getLocalHourAndMinute` | ≈ 115,6 µs | ≈ 1,7 µs | ≈ 69× |
| Podiel `getLocalHourAndMinute` (total) v profile | 85,9 % | 46,9 % | — |
| Podiel `isValidIanaTimezone` (self) v profile | 37,4 % | 4,5 % | — |
| Celkový navzorkovaný čas profilu (10 × 3 + 20 warm-up) | 13 198 ms | 421,5 ms | −96,8 % |
| Heap po behu | 18,2 MB | 19,1 MB | bez podstatnej zmeny |
| Kontrolný súčet výstupu | 228400 | 228400 | rovnaký |

Prečo je to dôležité: tieto funkcie sa volajú pri každom renderi komponentov
`planner-day-view`, `planner-week-view` a `daily-calendar-widget`. Pri plnom týždni teda
výpočet rozloženia klesol z ~260 ms (viditeľné zaseknutie UI, viac ako 15 snímok pri 60 FPS)
na ~4 ms. `isValidIanaTimezone` sa navyše volá v takmer každej funkcii v `time.ts`,
takže memoizácia zrýchľuje aj ostatné časové pomocné funkcie.

## Zmeny

- `src/lib/time.ts`
  - `isValidIanaTimezone`: memoizácia výsledku v ohraničenej `Map<string, boolean>`.
  - `getLocalHourAndMinute`: jeden `Intl.DateTimeFormat` na časové pásmo v ohraničenej `Map`.
- `tests/temporal-engine.test.ts`: nový blok testov. Overuje, že opakované a prekladané volania
  pre rôzne pásma (`Asia/Kolkata`, `America/New_York`, `UTC`) vracajú správne hodnoty,
  že neplatné pásmo zostáva neplatné aj z cache a stále padá na UTC, a že neplatný dátum vracia `0:00`.
- `scratch/profile-calendar-layout.ts`: reprodukovateľný profilovací scenár (benchmark).
- `scratch/summarize-cpuprofile.mjs`: textový súhrn súboru `.cpuprofile` bez závislostí.
- `docs/profiling/calendar-layout/`: výstupy profilácie pred a po úprave a tento popis.

## Overenie

- `npm test`: **102/102 test suites prešlo** (vrátane `temporal-engine`, `calendar-domain-validation`, `planner-ux-validation`).
- `npm run typecheck` (`tsc --noEmit`): bez chýb.
- `eslint src/lib/time.ts`: bez chýb.

## Možné ďalšie kroky (mimo rozsahu tohto MR)

Rovnaký vzor (`new Intl.DateTimeFormat` pri každom volaní) sa nachádza aj v ďalších funkciách
v `time.ts`, napr. `getLocalDateString`, `getIsoWeekAndYear`, `utcToDatetimeLocalInput`,
`getTimezoneOffsetMinutes` (volaná z `localToUtc`) a `getWeekDaysForDate`. Tie sa dajú zrýchliť
rovnakou cache formátovačov, ak ich profilácia v inom scenári označí za úzke miesto.
