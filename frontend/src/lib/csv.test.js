import { parseCsv } from "./csv";

test("parses quoted commas and escaped quotes", () => {
  expect(parseCsv('stable_id,test_scenario\nR-01,"Check ""quoted"", text"\n')).toEqual([
    { stable_id: "R-01", test_scenario: 'Check "quoted", text' },
  ]);
});