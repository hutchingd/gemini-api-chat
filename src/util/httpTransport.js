import followRedirects from 'follow-redirects';

export const MAX_HTTP_HEADER_SIZE = 256 * 1024;

export const largeHeaderTransport = {
  request(options, callback) {
    const transport = options.protocol === 'http:' ? followRedirects.http : followRedirects.https;
    return transport.request({ ...options, maxHeaderSize: MAX_HTTP_HEADER_SIZE }, callback);
  },
};
