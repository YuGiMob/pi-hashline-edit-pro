import { afterEach } from "vitest";
import { resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";

afterEach(() => {
  resetRegistryForTests();
  resetBatchStateForTests();
});
