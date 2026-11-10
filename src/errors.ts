export class PgExtrasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgExtrasError";
  }
}
