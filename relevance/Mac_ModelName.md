

- `unique values of strings "product-name" of dictionaries of service planes of iokit registries`
- `unique values of strings "marketingModel" of dictionaries "_LOCALIZABLE_" of dictionaries (strings "product-name" of dictionaries of service planes of iokit registries) of dictionaries of files "/System/Library/PrivateFrameworks/ServerInformation.framework/Versions/Current/Resources/English.lproj/SIMachineAttributes.plist"`
  - based upon this by Aaron: https://macadmins.slack.com/archives/C0850FTMF/p1558723821001100
- `(item 0 of it & " - " & item 1 of it) of ( unique values of (it as trimmed string) of strings "product-name" of dictionaries of service planes of iokit registries,  unique values of (it as trimmed string) of strings "marketingModel" of dictionaries "_LOCALIZABLE_" of dictionaries (strings "product-name" of dictionaries of service planes of iokit registries) of dictionaries of files "/System/Library/PrivateFrameworks/ServerInformation.framework/Versions/Current/Resources/English.lproj/SIMachineAttributes.plist" )`
