const Share = {
  open: jest.fn().mockResolvedValue({ success: true, message: 'OK' }),
  shareSingle: jest.fn().mockResolvedValue({ success: true, message: 'OK' }),
  isPackageInstalled: jest.fn().mockResolvedValue({ isInstalled: true }),
  Social: {
    FACEBOOK: 'facebook',
    FACEBOOK_STORIES: 'facebookstories',
    PAGESMANAGER: 'pagesmanager',
    TWITTER: 'twitter',
    WHATSAPP: 'whatsapp',
    WHATSAPPBUSINESS: 'whatsappbusiness',
    INSTAGRAM: 'instagram',
    INSTAGRAM_STORIES: 'instagramstories',
    GOOGLEPLUS: 'googleplus',
    EMAIL: 'email',
    PINTEREST: 'pinterest',
    LINKEDIN: 'linkedin',
    SMS: 'sms',
    TELEGRAM: 'telegram',
    MESSENGER: 'messenger',
    SNAPCHAT: 'snapchat',
    VIBER: 'viber',
    DISCORD: 'discord',
  },
};

export default Share;
