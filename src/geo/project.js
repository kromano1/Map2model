// Local equirectangular projection from WGS84 lon/lat into model millimetres.
// The model is centred on (0, 0); +x is east, +y is north. For the area sizes
// this tool supports (up to a few hundred km) the distortion is negligible
// for a printed object, and it keeps the elevation grid perfectly regular.

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/**
 * @param {{west:number,south:number,east:number,north:number}} bbox
 * @param {number} widthMM  printed width of the model along x
 */
export function makeProjection(bbox, widthMM) {
  const lat0 = (bbox.south + bbox.north) / 2;
  const lon0 = (bbox.west + bbox.east) / 2;
  const k = Math.cos(lat0 * DEG);
  const widthM = (bbox.east - bbox.west) * DEG * EARTH_RADIUS_M * k;
  const heightM = (bbox.north - bbox.south) * DEG * EARTH_RADIUS_M;
  const mmPerM = widthMM / widthM;
  const heightMM = heightM * mmPerM;

  return {
    bbox,
    widthM,
    heightM,
    widthMM,
    heightMM,
    mmPerM,
    /** [lon, lat] -> [x, y] in mm */
    toMM(lon, lat) {
      return [
        (lon - lon0) * DEG * EARTH_RADIUS_M * k * mmPerM,
        (lat - lat0) * DEG * EARTH_RADIUS_M * mmPerM,
      ];
    },
    /** grid node (i, j) of a cols x rows grid -> [lon, lat] */
    nodeLonLat(i, j, cols, rows) {
      return [
        bbox.west + (i / cols) * (bbox.east - bbox.west),
        bbox.south + (j / rows) * (bbox.north - bbox.south),
      ];
    },
  };
}

/** Real-world size of a bbox in metres. */
export function bboxSizeMeters(bbox) {
  const lat0 = (bbox.south + bbox.north) / 2;
  return {
    width: (bbox.east - bbox.west) * DEG * EARTH_RADIUS_M * Math.cos(lat0 * DEG),
    height: (bbox.north - bbox.south) * DEG * EARTH_RADIUS_M,
  };
}
