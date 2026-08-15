const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** Returns true only for a two-segment repository identity safe to place in a URL path. */
export const isRepositoryIdentity = (value: string): boolean => {
  const segments = value.split("/");
  return (
    segments.length === 2 &&
    segments.every(
      (segment) => REPOSITORY_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..",
    )
  );
};
