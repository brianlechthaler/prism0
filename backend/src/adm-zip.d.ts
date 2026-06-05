declare module "adm-zip" {
  export default class AdmZip {
    constructor(buffer?: Buffer);
    addFile(name: string, data: Buffer): void;
    toBuffer(): Buffer;
    getEntries(): Array<{ entryName: string }>;
  }
}
