import { afterEach } from "vitest";
import { resetRegistryForTests } from "../../src/anchor-registry";

afterEach(() => {
  resetRegistryForTests();
});
