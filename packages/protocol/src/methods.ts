type Method = (...args: unknown[]) => Promise<unknown>;

// Every method name of `T`: a missing or an unknown name fails the type check.
export const methodsOf = <T>(names: Record<keyof T & string, true>) =>
  Object.keys(names) as (keyof T & string)[];

// Only the listed methods, on an object without a prototype, so the other side reaches nothing else.
export const wrapMethods = <T extends object>(
  target: T,
  methods: readonly (keyof T & string)[],
  wrap: (method: Method, name: keyof T & string) => Method,
) => {
  const wrapped: Record<string, Method> = Object.create(null);
  for (const name of methods) {
    wrapped[name] = wrap((...args) => (target[name] as Method).apply(target, args), name);
  }
  return wrapped as unknown as T;
};

export const exposed = <T extends object>(target: T, methods: readonly (keyof T & string)[]) =>
  wrapMethods(target, methods, (method) => method);
