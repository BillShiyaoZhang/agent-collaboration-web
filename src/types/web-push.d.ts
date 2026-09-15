declare module "web-push" {
  const webpush: {
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
    sendNotification(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string,
      options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: "normal"; topic: string; timeout: number }): Promise<{ statusCode: number }>;
  };
  export default webpush;
}
