/// <reference path="../../src/host.d.ts" />
// Senkognito uses the same GraphQL backend as Senkuro — schema, queries
// and DTO shapes are identical. Only the host differs, so we extend the
// Senkuro source and override the three endpoint fields it exposes for
// this exact reason. esbuild inlines both files; the resulting bundle
// is self-contained.

import SenkuroSource from "../senkuro/source";

class SenkognitoSource extends SenkuroSource {
  protected endpoint = "https://api.senkognito.com/graphql";
  protected webHost  = "senkognito.com";
  protected referer  = "https://senkognito.com/";
}

export default SenkognitoSource;
