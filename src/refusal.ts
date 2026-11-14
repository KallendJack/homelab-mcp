/** A Tool won't do what the Client asked. The message says why, as a sentence the Client is shown as it is. */
export class Refusal extends Error {
  /** More about why, for the server's log only, such as a command's own error output. The Client never sees it. */
  readonly logDetail: string | undefined;

  constructor(message: string, options: { logDetail?: string } = {}) {
    super(message);
    this.logDetail = options.logDetail;
  }
}
