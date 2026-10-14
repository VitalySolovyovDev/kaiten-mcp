import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { KaitenClient } from '../src/kaiten.js';
import { KaitenError } from '../src/errors.js';

const config = () => loadConfig({ KAITEN_BASE_URL: 'https://tasks.example', KAITEN_API_TOKEN: 'secret', KAITEN_MAX_TEXT_CHARS: '5' });
describe('bounded and partial reads', () => {
  it('preserves description continuation and reports inaccessible comments', async () => {
    const client = new KaitenClient(config());
    vi.spyOn(client, 'rawCard').mockResolvedValue({ id: 1, title: 'Card', description: 'abcdefghij', files: [] });
    vi.spyOn(client, 'rawComments').mockRejectedValue(new KaitenError('FORBIDDEN','Access denied.',403));
    const first = await client.getCard('https://tasks.example/1');
    expect(first.description.text).toBe('abcde'); expect(first.description.next_offset).toBe(5);
    expect(first.attachments_complete).toBe(false); expect(first.warnings?.[0]).toContain('FORBIDDEN');
    expect((await client.getCard('https://tasks.example/1', 5)).description.text).toBe('fghij');
  });
  it('bounds aggregate comment text without skipping a continuation', async () => {
    const client = new KaitenClient(config());
    const comments = [{ id:1, text:'abcdefghij', author_id:1 }, { id:2, text:'other', deleted:true }, { id:3, text:'third' }];
    vi.spyOn(client, 'rawComments').mockImplementation(async (_id, offset, limit) => comments.slice(offset, offset+limit));
    const first = await client.getComments('https://tasks.example/1');
    expect(first.comments[0].text).toBe('abcde'); expect(first.comments[0].next_text_offset).toBe(5); expect(first.next_offset).toBe(1);
    const continued = await client.getComments('https://tasks.example/1', 0, 1, 5);
    expect(continued.comments[0].text).toBe('fghij'); expect(continued.comments[0].next_text_offset).toBeNull();
    const last = await client.getComments('https://tasks.example/1', 1);
    expect(last.comments.map(c=>c.text)).toEqual(['','third']); expect(last.next_offset).toBeNull();
  });
  it('marks an API that ignores pagination as incomplete', async () => {
    const client = new KaitenClient(config());
    vi.spyOn(client, 'rawCard').mockResolvedValue({ id:1, title:'Card', files:[] });
    vi.spyOn(client, 'rawComments').mockResolvedValue(Array.from({length:100},(_,i)=>({id:i})));
    const result = await client.getCard('https://tasks.example/1');
    expect(result.attachments_complete).toBe(false); expect(result.warnings?.[0]).toContain('PAGINATION_INVALID');
  });
  it('resolves a protected comment file whose parent UID is only in the comment list', async () => {
    const client = new KaitenClient(config());
    vi.spyOn(client, 'rawCard').mockResolvedValue({ id:1, uid:'card-uid', title:'Card', files:[{id:'file-uid',type:11,comment_id:2,name:'note.txt'}] });
    vi.spyOn(client, 'rawComments').mockResolvedValue([{id:2,uid:'comment-uid',text:'Comment'}]);
    const request = vi.spyOn(client.http,'json').mockResolvedValue({url:'https://files.example/note.txt'});
    vi.spyOn(client.http,'file').mockResolvedValue({bytes:Buffer.from('hello'),mimeType:'text/plain'});
    const file = await client.attachment('https://tasks.example/1','file-uid');
    expect(file.attachment.comment_uid).toBe('comment-uid');
    expect(request).toHaveBeenCalledWith('cards/card-uid/comments/comment-uid/files/file-uid');
  });
});
