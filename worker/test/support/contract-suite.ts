import { describe } from "@effect/vitest";

export interface ContractImplementation<T> {
  readonly name: string;
  readonly make: T;
  readonly enabled?: boolean;
}

export const runContractSuite = <T>(
  name: string,
  implementations: ReadonlyArray<ContractImplementation<T>>,
  define: (implementation: ContractImplementation<T>) => void,
): void => {
  describe(name, () => {
    for (const implementation of implementations) {
      const register = implementation.enabled === false ? describe.skip : describe;
      register(implementation.name, () => define(implementation));
    }
  });
};
