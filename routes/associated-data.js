var router = require('express').Router();
var AV = require('leanengine');
var Promise = require('bluebird');
var _ = require('underscore');

var redisClient = require('../redisConn');

/*
 * 缓存关联数据示例
 *
 * 这种模式适合被关联的数据量少、查询频繁、不常修改，或者关联结构非常复杂（需要多次查询或需要对被关联对象做计算）的情况，
 * 应用合理的话可以减少对云存储的查询次数、缩短请求的处理时间，但要注意当关联对象被修改时要及时刷新缓存，否则会出现数据不同步的情况。
 *
 * 例如我们有一个社区，Post 代表一篇文章，author 字段是一个 User 对象，代表文章的作者。
 * 在这个社区中活跃用户的数量和文章数量相比较小，且用户对象上的数据也不常变化（可以通过 User 的 afterUpdate Hook 来刷新缓存）。
*/

var Post = AV.Object.extend('Post');

/* 生成测试数据，创建 100 个 Post, 从 User 表中随机选择用户作为 author */
router.post('/createPosts', function(req, res, next) {
  new AV.Query(AV.User).find().then(function(users) {
    AV.Object.saveAll(_.range(1, 100).map(function() {
      var post = new Post();
      post.set('author', _.sample(users));
      return post;
    })).then(function() {
      res.send();
    })
  }).catch(next);
});

/* 查询 100 个 Post */
router.get('/posts', function(req, res, next) {
  new AV.Query(Post).find().then(function(posts) {
    return fetchUsersFromCache(posts.map(function(post) {
      return post.get('author').id;
    })).then(function(users) {
      res.json(posts.map(function(post) {
        return _.extend(post.toJSON(), {
          author: _.find(users, {id: post.get('author').id})
        });
      }))
    });
  }).catch(next);
});

/* 查询单个 Post */
router.get('/posts/:id', function(req, res, next) {
  new AV.Query(Post).get(req.params.id).then(function(post) {
    return fetchUsersFromCache([post.get('author').id]).then(function(users) {
      res.json(_.extend(post.toJSON(), {
        author: users[0]
      }));
    });
  }).catch(next);
});

/* 在 User 被修改后删除缓存 */
AV.Cloud.afterUpdate('_User', function(request) {
  redisClient.delAsync(redisUserKey(request.object.id)).catch(console.error)
});

/* 从缓存中读取一组 User, 如果没有找到则从云存储中查询 */
function fetchUsersFromCache(userIds) {
  var uniqueUserIds = _.uniq(userIds);

  // 先从 LeanCache 中查询
  return redisClient.mgetAsync(_.uniq(userIds).map(redisUserKey)).then(function(cachedUsers) {
    var parsedUsers = cachedUsers.map(function(user) {
      // 对 User（也就是 AV.Object）进行反序列化
      return new AV.User(JSON.parse(user), {parse: true});
    });

    // 找到 LeanCache 中没有缓存的那些 User
    var missUserIds = _.uniq(userIds.filter(function(userId) {
      return !_.find(parsedUsers, {id: userId});
    }));

    return Promise.try(function() {
      if (missUserIds.length) {
        // 从云存储中查询 LeanCache 中没有的 User
        return new AV.Query(AV.User).containedIn('objectId', missUserIds).find();
      } else {
        return [];
      }
    }).then(function(latestUsers) {
      if (latestUsers.length) {
        // 将从云存储中查询到的 User 缓存到 LeanCache, 此次为异步
        redisClient.msetAsync(_.flatten(latestUsers.map(function(user) {
          return [redisUserKey(user.id), JSON.stringify(user)];
        })));
      }

      // 将来自缓存和来自云存储的用户组合到一起作为结果返回
      return userIds.map(function(userId) {
        return _.find(parsedUsers, {id: userId}) || _.find(latestUsers, {id: userId});
      });
    });
  });
}

/* User 存储在 LeanCache 中的键名 */
function redisUserKey(userId) {
  return 'users:' + userId;
}

/*
 * 更进一步
 *
 * - 如果数据量较大，担心占用过多内存，可以考虑为缓存设置过期时间。
 * - 这个例子侧重展示关联数据，但在其实 Post 本身也是可以缓存的。
*/

module.exports = router;