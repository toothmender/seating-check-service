import exifr from "exifr";

// Re-encoding through a canvas drops ALL embedded metadata (EXIF, XMP, IPTC, GPS, thumbnails,
// ICC). This only reads the original's tags so the user can see what was in the file — it
// reports categories, never the values.
export async function describeMetadata(file) {
  let tags;
  try {
    tags = await exifr.parse(file, {
      tiff: true,
      xmp: true,
      iptc: true,
      gps: true,
      mergeOutput: true,
      translateKeys: true,
      translateValues: false,
      reviveValues: false,
    });
  } catch {
    return [];
  }
  if (!tags) return [];
  const keys = Object.keys(tags);
  if (keys.length === 0) return [];

  const has = (re) => keys.some((k) => re.test(k));
  const found = [];
  if (has(/^GPS/)) found.push("GPS location");
  if (has(/DateTime|CreateDate|ModifyDate|DateCreated|OffsetTime/i)) found.push("Date and time");
  if (has(/^(Make|Model|Software|LensModel|LensMake|HostComputer)$/)) found.push("Camera or device details");
  if (has(/Serial/i)) found.push("Device serial number");
  if (
    has(/^(ImageDescription|UserComment|Artist|Copyright|XP\w+|Creator|Title|Description|Subject|Keywords|Caption|Credit|Source|Byline)$/i)
  ) {
    found.push("Text fields (description, author, comments)");
  }
  found.push(`${keys.length} embedded metadata field${keys.length === 1 ? "" : "s"} in total`);
  return found;
}
