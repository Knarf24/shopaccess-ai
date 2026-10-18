/** What the device-profile page shows. Session storage lives elsewhere. */
export interface DeviceProfileDisplay {
  readonly version: number;
  readonly brand: string;
  readonly model: string;
  readonly brandSaved: boolean;
  readonly modelSaved: boolean;
}
